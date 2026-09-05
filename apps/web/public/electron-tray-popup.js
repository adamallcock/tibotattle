/**
 * Compact visual surface for the Electron tray popup.
 *
 * The local companion remains the only parsing and accounting authority. This
 * module consumes the normalized dashboard DTO from `data-client.js`, keeps a
 * bounded presentation projection, and never starts a detailed rebuild just
 * because the popup opened.
 */
import {
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  isPrimaryCodexQuotaWindow,
  LocalCompanionClient,
} from "./data-client.js";
import {
  createBrowserLocalization,
  DEFAULT_LOCALE,
  translate,
} from "./localization.js";
import {
  compact,
  formatAge,
  formatLocal,
  formatNumber,
  setFormattingLocale,
  setMessageLocale,
  USER_TIME_ZONE,
} from "./ui-format.js";

export const TRAY_POPUP_SCHEMA_VERSION = "electron-tray-popup-v1";
const PRODUCT_APP_NAME = "TiboTattle";
export const TRAY_POPUP_HISTORY_RANGES = Object.freeze({
  "7d": 7,
  "30d": 30,
});
export const TRAY_POPUP_ACTIONS = Object.freeze(["open", "refresh", "more"]);

const MAX_TIMELINE_ROWS = 3_000;
const MAX_HISTORY_DAYS = 30;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const DEFAULT_ALLOWANCE_STALE_AFTER_SECONDS = 30 * 60;
const PACE_STATUSES = new Set([
  "unavailable",
  "insufficient_observations",
  "available",
  "will_reach_reset_first",
]);
const HISTORY_STATUSES = new Set(["complete", "partial", "loading", "unavailable"]);
const ACCOUNTING_STATUSES = new Set(["available", "retained", "unavailable"]);
const TRAY_POPUP_MAIN_STATUSES = new Set([
  "starting",
  "analyzing",
  "fresh",
  "stale",
  "unavailable",
]);
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value, maximum = 80) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    return "";
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return "";
  }
  return value;
}

function nonNegativeNumber(value, { integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (integer && (!Number.isSafeInteger(value) || value > MAX_SAFE_INTEGER)) {
    return null;
  }
  return value;
}

function boundedPercent(value) {
  const number = nonNegativeNumber(value);
  return number === null || number > 100 ? null : number;
}

function boundedFraction(value) {
  const number = nonNegativeNumber(value);
  return number === null || number > 1 ? null : number;
}

function approximatelyEqual(left, right) {
  return Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= 0.000_001 * Math.max(1, Math.abs(left), Math.abs(right));
}

function instantMs(value) {
  if (value instanceof Date) {
    const ms = value.valueOf();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoInstant(value) {
  const ms = instantMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function clampDayCount(range) {
  return TRAY_POPUP_HISTORY_RANGES[range] ?? TRAY_POPUP_HISTORY_RANGES["7d"];
}

function safeTimeZone(value) {
  if (typeof value !== "string" || value.trim() === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return "UTC";
  }
}

function createCalendarFormatters(timeZone) {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateTimeParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return { dateParts, dateTimeParts };
}

function partsToRecord(parts) {
  return Object.fromEntries(
    parts.flatMap(({ type, value }) =>
      type === "year" || type === "month" || type === "day"
        || type === "hour" || type === "minute" || type === "second"
        ? [[type, Number(value)]]
        : []),
  );
}

function localDayKey(ms, dateParts) {
  const parts = partsToRecord(dateParts.formatToParts(new Date(ms)));
  if (![parts.year, parts.month, parts.day].every(Number.isSafeInteger)) return null;
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localDateTimeParts(ms, dateTimeParts) {
  const parts = Object.fromEntries(
    dateTimeParts.formatToParts(new Date(ms)).flatMap(({ type, value }) =>
      ["year", "month", "day", "hour", "minute", "second"].includes(type)
        ? [[type, Number(value)]]
        : []),
  );
  return parts;
}

function zonedOffsetMs(ms, dateTimeParts) {
  const parts = localDateTimeParts(ms, dateTimeParts);
  if (![parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second]
    .every(Number.isSafeInteger)) return null;
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - Math.trunc(ms / 1_000) * 1_000;
}

function dayKeyDate(key) {
  const match = DAY_KEY_PATTERN.exec(key);
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(value) ? value : null;
}

function addCalendarDays(key, offset) {
  const ms = dayKeyDate(key);
  if (ms === null) return null;
  const date = new Date(ms);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function zonedMidnightMs(key, formatters) {
  const utcGuess = dayKeyDate(key);
  if (utcGuess === null) return null;
  const firstOffset = zonedOffsetMs(utcGuess, formatters.dateTimeParts);
  if (firstOffset === null) return null;
  let result = utcGuess - firstOffset;
  const secondOffset = zonedOffsetMs(result, formatters.dateTimeParts);
  if (secondOffset !== null) result = utcGuess - secondOffset;
  return result;
}

function createDayWindows(anchorMs, dayCount, formatters) {
  const today = localDayKey(anchorMs, formatters.dateParts);
  if (today === null) return [];
  const windows = [];
  for (let index = dayCount - 1; index >= 0; index -= 1) {
    const key = addCalendarDays(today, -index);
    const nextKey = key === null ? null : addCalendarDays(key, 1);
    const startMs = key === null ? null : zonedMidnightMs(key, formatters);
    const endMs = nextKey === null ? null : zonedMidnightMs(nextKey, formatters);
    if (key === null || nextKey === null || startMs === null || endMs === null
        || endMs <= startMs) continue;
    windows.push(Object.freeze({ key, startMs, endMs }));
  }
  return windows;
}

function normalizeCoverage(value) {
  const status = HISTORY_STATUSES.has(value?.status) ? value.status : "unavailable";
  const startAt = isoInstant(value?.coveredAt?.startAt);
  const endAt = isoInstant(value?.coveredAt?.endAt);
  const startMs = instantMs(startAt);
  const endMs = instantMs(endAt);
  return {
    status,
    source: ["unified_local_index", "replay_safe_cache", "recent_collector_window"]
      .includes(value?.source) ? value.source : "",
    coveredAt: startMs !== null && endMs !== null && endMs > startMs
      ? Object.freeze({ startAt, endAt }) : null,
    startMs,
    endMs,
  };
}

function normalizeUsageRows(value) {
  if (!Array.isArray(value)) return { rows: [], valid: true };
  // The companion normalizer already bounds this list. A direct consumer must
  // still fail closed if an unbounded DTO reaches the popup: silently keeping
  // only the tail would make a complete-history label dishonest.
  if (value.length > MAX_TIMELINE_ROWS) return { rows: [], valid: false };
  const rows = [];
  for (const row of value) {
    if (!isObject(row)) return { rows: [], valid: false };
    const startAt = isoInstant(row.startAt);
    const endAt = isoInstant(row.endAt);
    const startMs = instantMs(startAt);
    const endMs = instantMs(endAt);
    const usageEvents = nonNegativeNumber(row.usageEvents, { integer: true });
    const totalTokens = nonNegativeNumber(row.totalTokens, { integer: true });
    const apiPriceEquivalentUsd = nonNegativeNumber(row.apiPriceEquivalentUsd);
    const coverage = row.pricingCoverage;
    const fullyPricedEvents = nonNegativeNumber(coverage?.fullyPricedEvents, { integer: true });
    const partiallyPricedEvents = nonNegativeNumber(coverage?.partiallyPricedEvents, { integer: true });
    const unpricedEvents = nonNegativeNumber(coverage?.unpricedEvents, { integer: true });
    if (startMs === null || endMs === null || endMs <= startMs
        || usageEvents === null || totalTokens === null
        || apiPriceEquivalentUsd === null
        || fullyPricedEvents === null || partiallyPricedEvents === null
        || unpricedEvents === null
        || fullyPricedEvents + partiallyPricedEvents + unpricedEvents !== usageEvents
        || (usageEvents === 0 && (totalTokens !== 0 || apiPriceEquivalentUsd !== 0))) {
      return { rows: [], valid: false };
    }
    rows.push(Object.freeze({
      startAt,
      endAt,
      startMs,
      endMs,
      usageEvents,
      totalTokens,
      apiPriceEquivalentUsd,
      pricingCoverage: Object.freeze({
        fullyPricedEvents,
        partiallyPricedEvents,
        unpricedEvents,
      }),
    }));
  }
  return { rows, valid: true };
}

function sumValues(rows, key) {
  let total = 0;
  for (const row of rows) {
    const value = valueAtPath(row, key);
    if (typeof value !== "number") return null;
    total += value;
    if (!Number.isFinite(total)
        || (key !== "apiPriceEquivalentUsd" && !Number.isSafeInteger(total))) return null;
  }
  return total;
}

function summarizeRows(rows) {
  const usageEvents = sumValues(rows, "usageEvents");
  const totalTokens = sumValues(rows, "totalTokens");
  const apiPriceEquivalentUsd = sumValues(rows, "apiPriceEquivalentUsd");
  const fullyPricedEvents = sumValues(rows, "pricingCoverage.fullyPricedEvents");
  const partiallyPricedEvents = sumValues(rows, "pricingCoverage.partiallyPricedEvents");
  const unpricedEvents = sumValues(rows, "pricingCoverage.unpricedEvents");
  if ([usageEvents, totalTokens, apiPriceEquivalentUsd, fullyPricedEvents,
    partiallyPricedEvents, unpricedEvents].includes(null)) return null;
  const pricingState = fullyPricedEvents + partiallyPricedEvents + unpricedEvents !== usageEvents
    ? "unavailable"
    : partiallyPricedEvents > 0 || unpricedEvents > 0
      ? "partial" : "complete";
  return Object.freeze({
    usageEvents,
    totalTokens,
    apiPriceEquivalentUsd,
    pricingCoverage: Object.freeze({
      fullyPricedEvents,
      partiallyPricedEvents,
      unpricedEvents,
    }),
    pricingState,
  });
}

function valueAtPath(row, path) {
  return path.split(".").reduce((value, key) => value?.[key], row);
}

function accountingPeriod(row, id) {
  if (!isObject(row)) return null;
  const events = nonNegativeNumber(row.events, { integer: true });
  const totalTokens = nonNegativeNumber(row.totalTokens, { integer: true });
  const apiPriceEquivalentUsd = nonNegativeNumber(row.apiPriceEquivalentUsd);
  const fullyPricedEvents = nonNegativeNumber(row.pricingCoverage?.fullyPricedEvents, { integer: true });
  const partiallyPricedEvents = nonNegativeNumber(row.pricingCoverage?.partiallyPricedEvents, { integer: true });
  const unpricedEvents = nonNegativeNumber(row.pricingCoverage?.unpricedEvents, { integer: true });
  if (events === null || totalTokens === null || apiPriceEquivalentUsd === null
      || fullyPricedEvents === null || partiallyPricedEvents === null
      || unpricedEvents === null) return null;
  const pricingTotal = fullyPricedEvents + partiallyPricedEvents + unpricedEvents;
  const pricingState = pricingTotal !== events
    ? "unavailable"
    : partiallyPricedEvents > 0 || unpricedEvents > 0 ? "partial" : "complete";
  return Object.freeze({
    periodId: id,
    periodLabel: boundedText(row.periodLabel, 80) || id,
    events,
    totalTokens,
    apiPriceEquivalentUsd,
    pricingCoverage: Object.freeze({
      fullyPricedEvents,
      partiallyPricedEvents,
      unpricedEvents,
    }),
    pricingState,
  });
}

function projectionStatus(accounting) {
  return ACCOUNTING_STATUSES.has(accounting?.projection?.status)
    ? accounting.projection.status : "unavailable";
}

const NORMAL_CODEX_ALLOWANCE_DURATIONS = Object.freeze([
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
]);
const NORMAL_CODEX_ALLOWANCE_DURATION_SET = new Set(NORMAL_CODEX_ALLOWANCE_DURATIONS);

/**
 * The popup has its own small admission boundary because the generic dashboard
 * normalizer preserves several display-only quota fields independently. Keep
 * the compact lanes aligned with the native reader: an inconsistent or
 * overlong provider window is unavailable, never rounded into a percentage.
 */
function canonicalAllowanceInstant(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null;
}

function normalCodexAllowanceCandidate(window, nowMs) {
  const durationMinutes = window?.durationMinutes;
  if (!isObject(window)
      || !isPrimaryCodexQuotaWindow(window)
      || !NORMAL_CODEX_ALLOWANCE_DURATION_SET.has(durationMinutes)) return null;
  const usedPercent = boundedPercent(window.usedPercent);
  const remainingPercent = boundedPercent(window.remainingPercent);
  const observedAt = canonicalAllowanceInstant(window.observedAt);
  const resetAt = canonicalAllowanceInstant(window.resetAt);
  const observedAtMs = instantMs(observedAt);
  const resetAtMs = instantMs(resetAt);
  if (usedPercent === null || remainingPercent === null
      || Math.abs((usedPercent + remainingPercent) - 100) > 0.001
      || observedAtMs === null || resetAtMs === null
      || observedAtMs > nowMs
      || resetAtMs <= observedAtMs
      || resetAtMs - observedAtMs > durationMinutes * 60_000) return null;
  // Unknown legacy slot values remain admissible but can never outrank the
  // provider's explicit primary slot. The bounded form exists only for a
  // deterministic internal tie-break and never reaches the rendered DTO.
  const slot = boundedText(window.slot, 80);
  return Object.freeze({
    durationMinutes,
    preferredSlot: slot === "primary",
    remainingPercent,
    observedAt,
    observedAtMs,
    resetAt,
    resetAtMs,
    status: window.status === "live" ? "live" : "unavailable",
    stableKey: [slot, resetAt, observedAt, String(remainingPercent)].join("\0"),
  });
}

function normalCodexAllowanceCandidateWins(candidate, prior) {
  if (prior === undefined) return true;
  if (candidate.preferredSlot !== prior.preferredSlot) return candidate.preferredSlot;
  if (candidate.observedAtMs !== prior.observedAtMs) {
    return candidate.observedAtMs > prior.observedAtMs;
  }
  return candidate.stableKey < prior.stableKey;
}

/**
 * Select exactly one structurally valid normal Codex lane for each duration.
 * This deliberately precedes freshness display checks: a stale explicit
 * primary does not authorize silently borrowing a sibling lane.
 */
function selectNormalCodexAllowanceLanes(data, nowMs) {
  const selected = new Map();
  for (const window of Array.isArray(data?.quotaWindows) ? data.quotaWindows : []) {
    const candidate = normalCodexAllowanceCandidate(window, nowMs);
    if (candidate === null) continue;
    const prior = selected.get(candidate.durationMinutes);
    if (normalCodexAllowanceCandidateWins(candidate, prior)) {
      selected.set(candidate.durationMinutes, candidate);
    }
  }
  return Object.freeze(NORMAL_CODEX_ALLOWANCE_DURATIONS
    .map((durationMinutes) => selected.get(durationMinutes))
    .filter((candidate) => candidate !== undefined));
}

function buildWeeklyPace(
  data,
  nowMs = Date.now(),
  selectedLanes = selectNormalCodexAllowanceLanes(data, nowMs),
) {
  const forecast = data?.weekly?.paceForecast;
  const outlook = data?.weekly?.paceOutlook;
  const nowInstant = instantMs(nowMs) ?? Date.now();
  const weeklyLane = selectedLanes.find((window) =>
    window.durationMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES);
  if (isObject(outlook)
      && outlook.schemaVersion === "local-weekly-pace-outlook-v0.1") {
    const invalid = () => Object.freeze({
      status: "unavailable",
      currentUsedPercent: null,
      remainingPercent: null,
      resetsAt: null,
      observationCount: null,
      etaAt: null,
      hoursToExhaustion: null,
      hoursToReset: null,
      pace: Object.freeze({
        method: null,
        sampleCount: null,
        elapsedHours: null,
        movementPp: null,
        activePercentagePointsPerHour: null,
        overallPercentagePointsPerHour: null,
      }),
      outlook: Object.freeze({
        kind: "unavailable",
        standing: null,
        critical: false,
        earlyEstimate: false,
        projectedExhaustionAt: null,
        coveredHours: null,
        dryHours: null,
        sparePercent: null,
        coveredFraction: null,
        activeExhaustionFraction: null,
      }),
    });
    const outlookKeys = [
      "schemaVersion", "status", "standing", "critical", "earlyEstimate",
      "remainingPercent", "resetsAt", "observationCount", "elapsedHours",
      "rates", "projection", "track",
    ];
    const rateKeys = [
      "activePercentagePointsPerHour", "overallPercentagePointsPerHour",
      "headlinePercentagePointsPerHour", "sustainablePercentagePointsPerHour", "ratio",
    ];
    const projectionKeys = [
      "hoursToReset", "coveredHours", "dryHours", "sparePercent",
      "projectedExhaustionAt",
    ];
    const trackKeys = ["coveredFraction", "activeExhaustionFraction"];
    if (!hasExactKeys(outlook, outlookKeys)
        || !hasExactKeys(outlook.rates, rateKeys)
        || !hasExactKeys(outlook.projection, projectionKeys)
        || !hasExactKeys(outlook.track, trackKeys)) return invalid();
    const status = ["unavailable", "collecting", "available"].includes(outlook.status)
      ? outlook.status : "unavailable";
    const remainingPercent = boundedPercent(outlook.remainingPercent);
    const resetsAt = isoInstant(outlook.resetsAt);
    const laneResetAt = isoInstant(weeklyLane?.resetAt);
    const hoursToReset = nonNegativeNumber(outlook.projection?.hoursToReset);
    const bound = weeklyLane
      && remainingPercent !== null
      && boundedPercent(weeklyLane.remainingPercent) !== null
      && Math.abs(remainingPercent - weeklyLane.remainingPercent) <= 0.001
      && resetsAt !== null && laneResetAt !== null
      && Math.abs(instantMs(resetsAt) - instantMs(laneResetAt)) <= 1_000
      && hoursToReset !== null && hoursToReset > 0
      && instantMs(resetsAt) > nowInstant
      && Math.abs(
        instantMs(resetsAt) - nowInstant - hoursToReset * 3_600_000,
      ) <= 120_000;
    const rates = outlook.rates;
    const outlookProjection = outlook.projection;
    const track = outlook.track;
    const standing = ["under", "on", "over"].includes(outlook.standing)
      ? outlook.standing : null;
    const validNumbers = [
      rates?.activePercentagePointsPerHour,
      rates?.overallPercentagePointsPerHour,
      rates?.headlinePercentagePointsPerHour,
      rates?.sustainablePercentagePointsPerHour,
      rates?.ratio,
      outlookProjection?.hoursToReset,
      outlookProjection?.coveredHours,
      outlookProjection?.dryHours,
      outlookProjection?.sparePercent,
      track?.coveredFraction,
      track?.activeExhaustionFraction,
    ].every((value) => value === null || nonNegativeNumber(value) !== null);
    const observationCount = nonNegativeNumber(outlook.observationCount, { integer: true });
    const elapsedHours = nonNegativeNumber(outlook.elapsedHours);
    const coveredHours = nonNegativeNumber(outlookProjection?.coveredHours);
    const dryHours = nonNegativeNumber(outlookProjection?.dryHours);
    const sparePercent = boundedPercent(outlookProjection?.sparePercent);
    const coveredFraction = boundedFraction(track?.coveredFraction);
    const activeExhaustionFraction = boundedFraction(track?.activeExhaustionFraction);
    const projectedRaw = outlookProjection?.projectedExhaustionAt;
    const projectedExhaustionAt = projectedRaw === null ? null : isoInstant(projectedRaw);
    const projectedIsFresh = projectedExhaustionAt === null
      || instantMs(projectedExhaustionAt) > nowInstant;
    const exactBooleans = typeof outlook.critical === "boolean"
      && typeof outlook.earlyEstimate === "boolean";
    const headlineRate = nonNegativeNumber(rates?.headlinePercentagePointsPerHour);
    const sustainableRate = nonNegativeNumber(rates?.sustainablePercentagePointsPerHour);
    const ratio = nonNegativeNumber(rates?.ratio);
    const activeRate = nonNegativeNumber(rates?.activePercentagePointsPerHour);
    const overallRate = nonNegativeNumber(rates?.overallPercentagePointsPerHour);
    const collecting = status === "collecting"
      && standing === null
      && outlook.critical === false
      && outlook.earlyEstimate === false
      && observationCount === 1
      && elapsedHours !== null
      && hoursToReset !== null && hoursToReset > 0
      && [activeRate, overallRate, headlineRate, sustainableRate, ratio,
        coveredHours, dryHours, sparePercent, projectedExhaustionAt,
        coveredFraction, activeExhaustionFraction].every((value) => value === null);
    const expectedActiveFraction = activeRate !== null && activeRate > 0
      && coveredHours !== null
      && remainingPercent !== null
      && remainingPercent / activeRate < coveredHours * 0.95
      ? Math.max(0, Math.min(1, (remainingPercent / activeRate) / (hoursToReset ?? 1)))
      : null;
    const activeFractionMatches = expectedActiveFraction === null
      ? activeExhaustionFraction === null
      : activeExhaustionFraction !== null
        && approximatelyEqual(activeExhaustionFraction, expectedActiveFraction);
    const availableShape = status === "available"
      && standing !== null
      && observationCount !== null && observationCount >= 2
      && elapsedHours !== null && elapsedHours > 0
      && remainingPercent !== null && remainingPercent > 0
      && hoursToReset !== null && hoursToReset > 0
      && coveredHours !== null && dryHours !== null && sparePercent !== null
      && coveredFraction !== null
      && headlineRate !== null && headlineRate > 0
      && sustainableRate !== null && sustainableRate > 0
      && ratio !== null && ratio > 0
      && (activeRate === null || activeRate > 0)
      && (overallRate === null || overallRate > 0)
      && approximatelyEqual(headlineRate, overallRate ?? activeRate)
      && approximatelyEqual(sustainableRate, remainingPercent / hoursToReset)
      && approximatelyEqual(ratio, headlineRate / sustainableRate)
      && approximatelyEqual(coveredHours + dryHours, hoursToReset)
      && approximatelyEqual(
        coveredHours,
        Math.min(hoursToReset, remainingPercent / headlineRate),
      )
      && approximatelyEqual(sparePercent, Math.max(0, remainingPercent - headlineRate * hoursToReset))
      && approximatelyEqual(coveredFraction, coveredHours / hoursToReset)
      && (standing === "under" ? ratio < 0.85
        : standing === "on" ? ratio >= 0.85 && ratio <= 1.15 : ratio > 1.15)
      && outlook.critical === (standing === "over" && ratio >= 2)
      && (!outlook.earlyEstimate || observationCount <= 2 || elapsedHours < 1)
      && activeFractionMatches;
    const projectedMatches = standing === "over"
      ? projectedExhaustionAt !== null
        && instantMs(projectedExhaustionAt) < instantMs(resetsAt)
        && dryHours !== null
        && Math.abs(
          instantMs(projectedExhaustionAt)
            - (instantMs(resetsAt) - dryHours * 3_600_000),
        ) <= 10
      : projectedExhaustionAt === null;
    if (!bound || !validNumbers || !exactBooleans || !projectedIsFresh
        || (projectedRaw !== null && projectedExhaustionAt === null)
        || (!collecting && (!availableShape || !projectedMatches))) return invalid();
    if (collecting) {
      return Object.freeze({
        status,
        currentUsedPercent: remainingPercent === null ? null : 100 - remainingPercent,
        remainingPercent,
        resetsAt,
        observationCount,
        etaAt: null,
        hoursToExhaustion: null,
        hoursToReset,
        pace: Object.freeze({
          method: null,
          sampleCount: 0,
          elapsedHours,
          movementPp: null,
          activePercentagePointsPerHour: null,
          overallPercentagePointsPerHour: null,
        }),
        outlook: Object.freeze({
          kind: "unavailable",
          standing: null,
          critical: false,
          earlyEstimate: false,
          projectedExhaustionAt: null,
          coveredHours: null,
          dryHours: null,
          sparePercent: null,
          coveredFraction: null,
          activeExhaustionFraction: null,
        }),
      });
    }
    const currentUsedPercent = remainingPercent === null ? null : 100 - remainingPercent;
    const result = {
      status,
      currentUsedPercent,
      remainingPercent,
      resetsAt,
      observationCount,
      etaAt: projectedExhaustionAt,
      hoursToExhaustion: null,
      hoursToReset,
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: observationCount === null ? null : Math.max(0, observationCount - 1),
        elapsedHours,
        movementPp: null,
        activePercentagePointsPerHour: nonNegativeNumber(rates?.activePercentagePointsPerHour),
        overallPercentagePointsPerHour: headlineRate,
      },
      outlook: {
        kind: projectedExhaustionAt === null ? "reset_first" : "exhaustion",
        standing,
        critical: outlook.critical,
        earlyEstimate: outlook.earlyEstimate,
        projectedExhaustionAt,
        coveredHours,
        dryHours,
        sparePercent,
        coveredFraction,
        activeExhaustionFraction,
      },
    };
    return Object.freeze({ ...result, pace: Object.freeze(result.pace), outlook: Object.freeze(result.outlook) });
  }

  // Older companions expose only the v0.2 forecast. Keep that path readable
  // while the current companion's exact v0.1 outlook is preferred above.
  const status = PACE_STATUSES.has(forecast?.status) ? forecast.status : "unavailable";
  const pace = forecast?.pace;
  const output = {
    status,
    currentUsedPercent: boundedPercent(forecast?.currentUsedPercent),
    remainingPercent: boundedPercent(forecast?.remainingPercent),
    resetsAt: isoInstant(forecast?.resetsAt),
    observationCount: nonNegativeNumber(forecast?.observationCount, { integer: true }),
    etaAt: isoInstant(forecast?.etaAt),
    hoursToExhaustion: nonNegativeNumber(forecast?.hoursToExhaustion),
    hoursToReset: nonNegativeNumber(forecast?.hoursToReset),
    pace: {
      method: pace?.method === "median_adjacent_quota_slope" ? pace.method : null,
      sampleCount: nonNegativeNumber(pace?.sampleCount, { integer: true }),
      elapsedHours: nonNegativeNumber(pace?.elapsedHours),
      movementPp: nonNegativeNumber(pace?.movementPp),
      activePercentagePointsPerHour: boundedPercent(pace?.activePercentagePointsPerHour),
      overallPercentagePointsPerHour: boundedPercent(pace?.overallPercentagePointsPerHour),
    },
    outlook: {
      kind: status === "will_reach_reset_first" ? "reset_first"
        : isoInstant(forecast?.etaAt) === null ? "unavailable" : "exhaustion",
      standing: null,
      critical: false,
      earlyEstimate: false,
      projectedExhaustionAt: isoInstant(forecast?.etaAt),
      coveredHours: null,
      dryHours: null,
      sparePercent: null,
      coveredFraction: null,
      activeExhaustionFraction: null,
    },
  };
  if (status === "available"
      && (output.currentUsedPercent === null || output.remainingPercent === null
        || output.resetsAt === null || output.etaAt === null
        || output.hoursToExhaustion === null || output.hoursToReset === null
        || output.pace.overallPercentagePointsPerHour === null)) {
    output.status = "unavailable";
    output.outlook.kind = "unavailable";
  }
  if (["available", "will_reach_reset_first", "insufficient_observations"]
    .includes(output.status)) {
    const resetMs = instantMs(output.resetsAt);
    const resetBound = resetMs !== null
      && output.hoursToReset !== null
      && output.hoursToReset > 0
      && resetMs > nowInstant
      && Math.abs(resetMs - nowInstant - output.hoursToReset * 3_600_000) <= 120_000;
    const etaBound = output.etaAt === null || instantMs(output.etaAt) > nowInstant;
    if (!resetBound || !etaBound) {
      output.status = "unavailable";
      output.outlook.kind = "unavailable";
    }
  }
  return Object.freeze({
    ...output,
    pace: Object.freeze(output.pace),
    outlook: Object.freeze(output.outlook),
  });
}

/**
 * Keep each numerical allowance tied to its own observation. A current weekly
 * reading does not make an older five-hour value current, and a reset that has
 * already passed never implies a new allowance window.
 */
function buildAllowances(
  data,
  nowMs = Date.now(),
  selectedLanes = selectNormalCodexAllowanceLanes(data, nowMs),
) {
  const nowInstant = instantMs(nowMs) ?? Date.now();
  const freshnessStatus = data?.freshness?.status ?? data?.state;
  const staleAfterSeconds = nonNegativeNumber(data?.freshness?.staleAfterSeconds)
    ?? DEFAULT_ALLOWANCE_STALE_AFTER_SECONDS;
  return selectedLanes
    .flatMap((window) => {
      const isCurrent = freshnessStatus === "live"
        && window.status === "live"
        && nowInstant - window.observedAtMs <= staleAfterSeconds * 1_000
        && window.resetAtMs > nowInstant;
      if (!isCurrent) return [];
      const labelKey = window.durationMinutes === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES
        ? "dashboard.quota.windowFiveHour" : "dashboard.quota.windowSevenDay";
      return [Object.freeze({
        durationMinutes: window.durationMinutes,
        labelKey,
        remainingPercent: Math.round(window.remainingPercent),
        resetAt: window.resetAt,
        resetInSeconds: Math.max(0, (window.resetAtMs - nowInstant) / 1_000),
      })];
    });
}

function buildHistory(data, range, nowMs, timeZone, accountingState) {
  const formatters = createCalendarFormatters(timeZone);
  const projection = data?.accounting;
  const projectionStatusValue = projectionStatus(projection);
  const retained = accountingState === "retained";
  const snapshotMs = retained
    ? instantMs(projection?.projection?.retainedAt)
      ?? instantMs(projection?.staleServe?.computedAt)
      ?? nowMs
    : nowMs;
  const dayWindows = createDayWindows(snapshotMs, MAX_HISTORY_DAYS, formatters);
  const coverage = normalizeCoverage(data?.timeline?.history);
  const accountingHistory = projection?.historyCoverage;
  const discoveryPartial = accountingHistory?.status === "partial"
    && [accountingHistory.sourceCount, accountingHistory.indexedSourceCount,
      accountingHistory.pendingSourceCount, accountingHistory.skippedSourceCount]
      .some((value) => Number.isSafeInteger(value) && value > 0);
  let status = coverage.status;
  if (projectionStatusValue === "unavailable" || !coverage.coveredAt
      || !["complete", "partial"].includes(status)) status = "unavailable";
  if (discoveryPartial && status === "complete") status = "partial";
  const normalizedRows = normalizeUsageRows(data?.timeline?.usage);
  if (!normalizedRows.valid) status = "unavailable";
  const groups = new Map();
  for (const row of normalizedRows.rows) {
    const key = localDayKey(row.startMs, formatters.dateParts);
    if (!key) {
      status = "unavailable";
      continue;
    }
    const current = groups.get(key) ?? [];
    current.push(row);
    groups.set(key, current);
  }
  const days = dayWindows.map((window) => {
    const intersectsCoverage = status !== "unavailable"
      && window.startMs < coverage.endMs && window.endMs > coverage.startMs;
    const fullCoverage = intersectsCoverage
      && window.startMs >= coverage.startMs
      && window.endMs <= coverage.endMs
      && window.endMs <= snapshotMs
      && status === "complete";
    const rows = groups.get(window.key) ?? [];
    const summary = rows.length > 0 ? summarizeRows(rows) : null;
    const evidence = !intersectsCoverage
      ? "unavailable"
      : summary === null
        ? fullCoverage ? "unavailable" : "partial"
        : fullCoverage ? "available" : "partial";
    const reportedSummary = evidence === "unavailable" ? null : summary;
    return Object.freeze({
      key: window.key,
      startAt: new Date(window.startMs).toISOString(),
      endAt: new Date(window.endMs).toISOString(),
      evidence,
      usageEvents: reportedSummary?.usageEvents ?? null,
      totalTokens: reportedSummary?.totalTokens ?? null,
      apiPriceEquivalentUsd: reportedSummary?.apiPriceEquivalentUsd ?? null,
      pricingCoverage: reportedSummary?.pricingCoverage ?? null,
      pricingState: reportedSummary?.pricingState ?? "unavailable",
    });
  });
  const selectedDays = days.slice(-clampDayCount(range));
  const rawPeriod = accountingPeriod(
    (Array.isArray(projection?.periods) ? projection.periods : [])
      .find((row) => row?.periodId === range),
    range,
  );
  // A period record from an unavailable accounting projection cannot make a
  // numerical history claim. Keep its absence explicit to the renderer.
  const period = accountingState === "unavailable" ? null : rawPeriod;
  const pricingState = period?.pricingState ?? "unavailable";
  return Object.freeze({
    range,
    dayCount: selectedDays.length,
    status,
    coverageState: status,
    coveredAt: coverage.coveredAt,
    source: coverage.source,
    retained,
    days: Object.freeze(selectedDays),
    period,
    pricingState,
    discoveryCoverage: accountingHistory?.status === "partial"
      ? Object.freeze({
        indexedSourceCount: accountingHistory.indexedSourceCount,
        sourceCount: accountingHistory.sourceCount,
        skippedSourceCount: accountingHistory.skippedSourceCount,
      }) : null,
  });
}

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Build the closed DTO consumed by the popup renderer. The function only
 * copies bounded, presentation-safe fields; no identifiers, paths, or raw
 * provider records are carried into the result.
 */
export function createTrayPopupProjection(data = {}, {
  range = "7d",
  now = Date.now(),
  timeZone = USER_TIME_ZONE,
} = {}) {
  const selectedRange = Object.hasOwn(TRAY_POPUP_HISTORY_RANGES, range) ? range : "7d";
  const nowMs = instantMs(now) ?? Date.now();
  const selectedTimeZone = safeTimeZone(timeZone);
  const accounting = data?.accounting;
  const projection = projectionStatus(accounting);
  const selectedAllowanceLanes = selectNormalCodexAllowanceLanes(data, nowMs);
  const retained = projection === "retained"
    || isObject(accounting?.staleServe);
  const accountingState = retained ? "retained" : projection === "available" ? "current" : "unavailable";
  const freshnessStatus = ["live", "stale", "demo", "offline", "insufficient"]
    .includes(data?.freshness?.status) ? data.freshness.status
    : ["live", "stale", "demo", "offline", "insufficient"].includes(data?.state)
      ? data.state : "insufficient";
  const latestObservedAt = isoInstant(data?.freshness?.latestObservedAt);
  const latestObservedMs = instantMs(latestObservedAt);
  const ageSeconds = latestObservedMs !== null && latestObservedMs <= nowMs
    ? (nowMs - latestObservedMs) / 1_000 : null;
  const freshness = Object.freeze({
    status: freshnessStatus,
    latestObservedAt,
    ageSeconds,
    staleAfterSeconds: nonNegativeNumber(data?.freshness?.staleAfterSeconds)
      ?? DEFAULT_ALLOWANCE_STALE_AFTER_SECONDS,
    accountingStatus: ACCOUNTING_STATUSES.has(data?.freshness?.accountingStatus)
      ? data.freshness.accountingStatus : "",
    accountingAgeSeconds: nonNegativeNumber(data?.freshness?.accountingAgeSeconds),
  });
  return deepFreeze({
    schemaVersion: TRAY_POPUP_SCHEMA_VERSION,
    state: freshnessStatus,
    freshness,
    allowances: Object.freeze(buildAllowances(data, nowMs, selectedAllowanceLanes)),
    weeklyPace: buildWeeklyPace(data, nowMs, selectedAllowanceLanes),
    accounting: Object.freeze({
      status: accountingState,
      retained,
      period: accountingState === "unavailable" ? null : accountingPeriod(
        (Array.isArray(accounting?.periods) ? accounting.periods : [])
          .find((row) => row?.periodId === selectedRange),
        selectedRange,
      ),
    }),
    history: buildHistory(data, selectedRange, nowMs, selectedTimeZone, accountingState),
  });
}

/** Send only the reviewed host actions accepted by the Electron bridge. */
export function requestTrayPopupAction(bridge, action) {
  if (arguments.length !== 2
      || !TRAY_POPUP_ACTIONS.includes(action)
      || typeof bridge?.requestAction !== "function") return false;
  try {
    bridge.requestAction(action);
    return true;
  } catch {
    return false;
  }
}

function defaultText(key, values = {}) {
  return translate(key, values, DEFAULT_LOCALE);
}

function textNode(documentRef, value) {
  const node = documentRef.createElement("span");
  node.textContent = value;
  return node;
}

function setElementText(documentRef, id, value) {
  const element = documentRef.getElementById(id);
  if (element) element.textContent = value;
  return element;
}

function setHidden(documentRef, id, hidden) {
  const element = documentRef.getElementById(id);
  if (element) element.hidden = hidden;
  return element;
}

function displayPercent(value, numberFormatter = formatNumber) {
  return value === null ? "—" : `${numberFormatter(value, { maximumFractionDigits: 0 })}%`;
}

function displayMoney(value, numberFormatter = formatNumber) {
  if (value === null) return "—";
  if (value > 0 && value < 0.01) {
    return `<${numberFormatter(0.01, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return numberFormatter(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function calendarLabel(key, locale) {
  const ms = dayKeyDate(key);
  if (ms === null) return key;
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

function resetCountdown(seconds, t, numberFormatter) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return t("electron.trayPopover.resetUnavailable");
  }
  const totalMinutes = Math.max(1, Math.floor(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes % (24 * 60) / 60);
  const minutes = totalMinutes % 60;
  const count = (value) => numberFormatter(value, { maximumFractionDigits: 0 });
  if (days > 0) {
    return t("electron.trayPopover.resetDaysHours", {
      days: count(days),
      hours: count(hours),
    });
  }
  if (hours > 0) {
    return t("electron.trayPopover.resetHoursMinutes", {
      hours: count(hours),
      minutes: count(minutes),
    });
  }
  return t("electron.trayPopover.resetMinutes", { minutes: count(minutes) });
}

function historyCoverageCounts(days) {
  return days.reduce((counts, day) => {
    if (day?.evidence === "available") counts.complete += 1;
    else if (day?.evidence === "partial") counts.partial += 1;
    else counts.unavailable += 1;
    return counts;
  }, { complete: 0, partial: 0, unavailable: 0 });
}

function historyPriceCopy(period, t, numberFormatter) {
  if (period.pricingState === "complete") {
    return t("electron.trayPopover.usageSummary", {
      amount: displayMoney(period.apiPriceEquivalentUsd, numberFormatter),
      basis: t("electron.trayPopover.apiPriceEquivalent"),
    });
  }
  const pricedEvents = period.pricingCoverage.fullyPricedEvents
    + period.pricingCoverage.partiallyPricedEvents;
  if (period.pricingState === "partial" && pricedEvents > 0) {
    return `${t("electron.trayPopover.usageSummary", {
      amount: displayMoney(period.apiPriceEquivalentUsd, numberFormatter),
      basis: t("electron.trayPopover.apiPriceEquivalentPartial"),
    })} · ${t("electron.trayPopover.partialPricing")}`;
  }
  return `${t("electron.trayPopover.apiPriceEquivalentUnavailable")} ${t("electron.trayPopover.partialPricing")}`;
}

function allowanceUnavailableCopy(freshness, t) {
  if (freshness.status === "offline") return t("electron.trayPopover.errorTitle");
  if (freshness.status === "demo") return t("dashboard.quota.demo");
  if (freshness.status === "insufficient") return t("electron.trayPopover.startingTitle");
  return t("electron.trayPopover.staleTitle");
}

function renderAllowances(documentRef, projection, t, numberFormatter) {
  const list = documentRef.getElementById("allowance-lanes");
  if (!list) return;
  list.replaceChildren();
  for (const allowance of projection.allowances) {
    const article = documentRef.createElement("article");
    article.className = "electron-tray-popup-allowance";
    const heading = documentRef.createElement("div");
    heading.className = "electron-tray-popup-allowance-heading";
    const title = textNode(documentRef, t(allowance.labelKey));
    title.className = "electron-tray-popup-allowance-title";
    const value = textNode(documentRef, t("electron.trayPopover.remaining", {
      value: displayPercent(allowance.remainingPercent, numberFormatter),
    }));
    value.className = "electron-tray-popup-allowance-value";
    heading.append(title, value);
    const track = documentRef.createElement("div");
    track.className = "electron-tray-popup-progress";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", t(allowance.labelKey));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(allowance.remainingPercent));
    track.setAttribute("aria-valuetext", displayPercent(allowance.remainingPercent, numberFormatter));
    const fill = documentRef.createElement("span");
    fill.className = "electron-tray-popup-progress-fill";
    fill.style.width = `${allowance.remainingPercent}%`;
    track.append(fill);
    const detail = textNode(documentRef, t("electron.trayPopover.resets", {
      time: resetCountdown(allowance.resetInSeconds, t, numberFormatter),
    }));
    detail.className = "electron-tray-popup-muted electron-tray-popup-allowance-detail";
    article.append(heading, detail, track);
    list.append(article);
  }
  setHidden(documentRef, "allowance-unavailable", projection.allowances.length > 0);
  if (projection.allowances.length === 0) {
    setElementText(
      documentRef,
      "allowance-unavailable",
      allowanceUnavailableCopy(projection.freshness, t),
    );
  }
}

/**
 * The compact pace view is conditional. Its outlook has already passed the
 * exact reset/remaining validation in buildWeeklyPace; this last gate also
 * requires the matching weekly allowance to remain current for presentation.
 */
function renderWeeklyPace(documentRef, projection, t, numberFormatter, localFormatter) {
  const section = documentRef.getElementById("pace-section");
  const pace = projection.weeklyPace;
  const weeklyAllowance = projection.allowances.find((allowance) =>
    allowance.durationMinutes === CODEX_WEEKLY_ALLOWANCE_MINUTES);
  const resetMatches = weeklyAllowance !== undefined
    && instantMs(weeklyAllowance.resetAt) !== null
    && instantMs(pace.resetsAt) !== null
    && Math.abs(instantMs(weeklyAllowance.resetAt) - instantMs(pace.resetsAt)) <= 1_000;
  const hasBoundOutlook = ["reset_first", "exhaustion"].includes(pace.outlook?.kind);
  const available = pace.status === "available"
    && hasBoundOutlook
    && resetMatches;
  setHidden(documentRef, "pace-section", !available);
  if (!available) return;

  const standingKey = pace.outlook.critical
    ? "electron.trayPopover.paceCritical"
    : pace.outlook.standing === "over"
      ? "electron.trayPopover.paceOver"
      : pace.outlook.standing === "on"
        ? "electron.trayPopover.paceOn"
        : "electron.trayPopover.paceUnder";
  setElementText(documentRef, "pace-state", t(standingKey));
  const outlookCopy = pace.outlook.kind === "reset_first"
    ? t("electron.trayPopover.paceResetFirst")
    : pace.outlook.projectedExhaustionAt
      ? t("electron.trayPopover.paceExhaustion", {
        time: localFormatter(pace.outlook.projectedExhaustionAt),
      }) : t("weekly.headline.insufficient");
  setElementText(documentRef, "pace-outlook", outlookCopy);
  setElementText(documentRef, "pace-used", t("dashboard.quota.used", {
    value: displayPercent(pace.currentUsedPercent, numberFormatter),
  }));
  setElementText(documentRef, "pace-remaining", t("electron.trayPopover.remaining", {
    value: displayPercent(pace.remainingPercent, numberFormatter),
  }));
  const rate = pace.pace.overallPercentagePointsPerHour;
  setElementText(documentRef, "pace-rate", rate === null
    ? "—"
    : `${numberFormatter(rate, { maximumFractionDigits: 1 })} pp/h`);
  setElementText(documentRef, "pace-reset", t("electron.trayPopover.resets", {
    time: resetCountdown(weeklyAllowance.resetInSeconds, t, numberFormatter),
  }));
  const track = documentRef.getElementById("pace-track");
  const coveredPercent = pace.outlook.coveredFraction === null
    ? null : pace.outlook.coveredFraction * 100;
  if (track) {
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    if (coveredPercent === null) {
      track.removeAttribute("aria-valuenow");
      track.setAttribute("aria-valuetext", t("weekly.headline.insufficient"));
    } else {
      track.setAttribute("aria-valuenow", String(coveredPercent));
      track.setAttribute("aria-valuetext", displayPercent(coveredPercent, numberFormatter));
    }
  }
  const fill = documentRef.getElementById("pace-fill");
  if (fill) fill.style.width = coveredPercent === null ? "0%" : `${coveredPercent}%`;
  const marker = documentRef.getElementById("pace-active-marker");
  if (marker) {
    const activeFraction = pace.outlook.activeExhaustionFraction;
    marker.hidden = activeFraction === null;
    if (activeFraction !== null) marker.style.left = `${activeFraction * 100}%`;
  }
}

function renderHistory(documentRef, projection, t, numberFormatter, formattingLocale) {
  const history = projection.history;
  for (const button of documentRef.querySelectorAll?.("[data-history-range]") ?? []) {
    const active = button.dataset.historyRange === history.range;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-selected", active);
  }

  const period = history.period;
  const available = projection.accounting.status !== "unavailable" && period !== null;
  setHidden(documentRef, "history-available", !available);
  setHidden(documentRef, "history-unavailable", available);
  setHidden(documentRef, "history-retained", !available || !history.retained);
  if (!available) {
    setElementText(documentRef, "history-unavailable-title", t("electron.trayPopover.accountingUnavailableTitle"));
    setElementText(documentRef, "history-unavailable-body", t("electron.trayPopover.accountingUnavailableBody"));
    const bars = documentRef.getElementById("history-bars");
    if (bars) bars.replaceChildren();
    return;
  }

  if (history.retained) {
    setElementText(documentRef, "history-retained", t("electron.trayPopover.retainedHistory"));
  }
  const periodCopy = history.range === "30d"
    ? t("electron.trayPopover.periodLastThirtyDays")
    : t("electron.trayPopover.periodLastSevenDays");
  setElementText(documentRef, "history-period", periodCopy);
  setElementText(documentRef, "history-tokens", t("electron.trayPopover.tokenCount", {
    count: compact(period.totalTokens),
  }));
  const eventsCopy = period.events === 0
    ? t("electron.trayPopover.noUsageObserved", { period: periodCopy })
    : period.events === 1
      ? t("electron.trayPopover.usageChangeOne")
      : t("electron.trayPopover.usageChangesMany", {
        count: numberFormatter(period.events, { maximumFractionDigits: 0 }),
      });
  setElementText(documentRef, "history-events", eventsCopy);
  setElementText(documentRef, "history-price", historyPriceCopy(period, t, numberFormatter));

  const start = history.days.at(0)?.key ?? "";
  const end = history.days.at(-1)?.key ?? "";
  setElementText(documentRef, "history-start", calendarLabel(start, formattingLocale));
  setElementText(documentRef, "history-end", calendarLabel(end, formattingLocale));
  const counts = historyCoverageCounts(history.days);
  const hasCoverageGap = counts.partial > 0 || counts.unavailable > 0;
  setHidden(documentRef, "history-coverage", !hasCoverageGap);
  if (hasCoverageGap) {
    setElementText(documentRef, "history-coverage", t("electron.trayPopover.coverageMixed", {
      complete: numberFormatter(counts.complete, { maximumFractionDigits: 0 }),
      partial: numberFormatter(counts.partial, { maximumFractionDigits: 0 }),
      unavailable: numberFormatter(counts.unavailable, { maximumFractionDigits: 0 }),
    }));
  }

  const bars = documentRef.getElementById("history-bars");
  if (!bars) return;
  bars.dataset.range = history.range;
  bars.replaceChildren();
  const measured = history.days
    .map((day) => day.totalTokens)
    .filter((value) => value !== null);
  const maximum = Math.max(1, ...measured);
  for (const day of history.days) {
    const bar = documentRef.createElement("span");
    bar.className = `electron-tray-popup-history-bar evidence-${day.evidence}`;
    bar.setAttribute("role", "img");
    const label = calendarLabel(day.key, formattingLocale);
    const detail = day.totalTokens === null
      ? t("dashboard.timeline.missingData")
      : `${t("electron.trayPopover.tokenCount", { count: compact(day.totalTokens) })} · ${t("electron.trayPopover.usageChangesMany", {
        count: numberFormatter(day.usageEvents ?? 0, { maximumFractionDigits: 0 }),
      })}`;
    bar.setAttribute("aria-label", `${label}: ${detail}`);
    const fill = documentRef.createElement("span");
    fill.className = "electron-tray-popup-history-fill";
    if (day.totalTokens !== null) {
      fill.style.height = `${Math.max(2, day.totalTokens / maximum * 100)}%`;
    }
    bar.append(fill);
    bars.append(bar);
  }
}

function headerFreshnessCopy(freshness, t, mainStatus = null) {
  if (mainStatus === "starting") return t("electron.trayPopover.startingTitle");
  if (mainStatus === "analyzing") return t("electron.trayPopover.headerUpdating");
  if (freshness.status === "live"
      && freshness.latestObservedAt !== null
      && freshness.ageSeconds !== null) {
    return freshness.ageSeconds < 90
      ? t("electron.trayPopover.headerLive")
      : t("electron.trayPopover.headerLiveUpdated", {
        age: formatAge(freshness.ageSeconds),
      });
  }
  if (freshness.status === "stale") return t("electron.trayPopover.staleTitle");
  if (freshness.status === "demo") return t("dashboard.quota.demo");
  if (freshness.status === "offline") return t("electron.trayPopover.errorTitle");
  return t("electron.trayPopover.startingTitle");
}

/**
 * The Electron main process owns lifecycle state. The companion DTO remains
 * the source of allowance and history display, so only this small, known
 * presentation subset may cross from the model event into this renderer.
 */
function mainTrayPresentation(model) {
  try {
    if (!isObject(model)
        || !TRAY_POPUP_MAIN_STATUSES.has(model.status)
        || typeof model.refreshEnabled !== "boolean") return null;
    return Object.freeze({
      status: model.status,
      // Native never enables a refresh while it is starting or analyzing,
      // even if a malformed event tries to claim otherwise.
      refreshEnabled: model.refreshEnabled
        && !["starting", "analyzing"].includes(model.status),
    });
  } catch {
    return null;
  }
}

/**
 * Render the popup with DOM APIs only. The renderer accepts injected formatters
 * so its closed projection and sparse/error states remain easy to test.
 */
export function renderTrayPopup(documentRef, projection, {
  t = defaultText,
  bridge = globalThis.window?.tibotattleTrayPopover,
  mainModel = null,
  requiresMainModel = false,
  numberFormatter = formatNumber,
  localFormatter = formatLocal,
  formattingLocale = DEFAULT_LOCALE,
} = {}) {
  if (!documentRef || typeof documentRef.getElementById !== "function") {
    throw new TypeError("A document is required to render the tray popup.");
  }
  const translated = typeof t === "function" ? t : defaultText;
  const formatNumberImpl = typeof numberFormatter === "function" ? numberFormatter : formatNumber;
  const formatLocalImpl = typeof localFormatter === "function" ? localFormatter : formatLocal;
  const presentation = mainTrayPresentation(mainModel);
  renderAllowances(documentRef, projection, translated, formatNumberImpl);
  renderWeeklyPace(documentRef, projection, translated, formatNumberImpl, formatLocalImpl);
  renderHistory(documentRef, projection, translated, formatNumberImpl, formattingLocale);
  const freshness = projection.freshness;
  const freshnessCopy = headerFreshnessCopy(freshness, translated, presentation?.status ?? null);
  setElementText(documentRef, "tray-popup-freshness", freshnessCopy);
  const live = documentRef.getElementById("tray-popup-live");
  if (live) live.textContent = freshnessCopy;
  for (const button of documentRef.querySelectorAll?.("[data-action]") ?? []) {
    const action = button.dataset.action;
    button.textContent = action === "open"
      ? translated("electron.tray.open", { appName: PRODUCT_APP_NAME })
      : action === "more" ? "⋯" : translated("electron.trayPopover.refresh");
    if (action === "more") {
      button.setAttribute("aria-label", translated("electron.trayPopover.more"));
      button.setAttribute("title", translated("electron.trayPopover.more"));
    }
    const transportReady = typeof bridge?.requestAction === "function";
    const refreshReady = action !== "refresh"
      || requiresMainModel !== true
      || presentation?.refreshEnabled === true;
    button.disabled = !TRAY_POPUP_ACTIONS.includes(action) || !transportReady || !refreshReady;
  }
  return projection;
}

/**
 * Report the intrinsic popup height through the narrow preload bridge. The
 * renderer never chooses a window size itself; the main process clamps and
 * places the transient surface.
 */
export function observeTrayPopupContentHeight({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
} = {}) {
  const root = documentRef?.getElementById?.("tray-popup");
  const bridge = windowRef?.tibotattleTrayPopover;
  const ResizeObserverImpl = windowRef?.ResizeObserver ?? globalThis.ResizeObserver;
  if (!root || typeof bridge?.reportContentHeight !== "function"
      || typeof ResizeObserverImpl !== "function") return () => {};
  let lastReportedHeight = null;
  const report = () => {
    let height;
    try {
      height = Math.ceil(root.getBoundingClientRect().height);
    } catch {
      return;
    }
    if (!Number.isSafeInteger(height) || height < 1 || height === lastReportedHeight) {
      return;
    }
    lastReportedHeight = height;
    try {
      bridge.reportContentHeight(height);
    } catch {
      // The bridge can disappear while this transient renderer closes.
    }
  };
  let observer;
  try {
    observer = new ResizeObserverImpl(report);
    observer.observe(root);
    report();
  } catch {
    try {
      observer?.disconnect?.();
    } catch {
      // A failed observer setup has no usable lifecycle to preserve.
    }
    return () => {};
  }
  return () => {
    try {
      observer.disconnect();
    } catch {
      // The page can already be gone when Electron closes its transient view.
    }
  };
}

export async function bootstrapTrayPopup({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  client = new LocalCompanionClient(),
} = {}) {
  if (!documentRef || !windowRef) return null;
  const localization = createBrowserLocalization({ windowRef, documentRef });
  setFormattingLocale(localization.formatLocale());
  setMessageLocale(localization.locale());
  const bridge = windowRef.tibotattleTrayPopover;
  const requiresMainModel = typeof bridge?.onModel === "function";
  let mainModel = null;
  let range = "7d";
  let data = null;
  let loadSequence = 0;
  let loadInFlight = null;
  let loadPending = false;
  const hasNativeVisibility = typeof bridge?.getVisibility === "function";
  const isVisible = () => {
    if (hasNativeVisibility) {
      try {
        return bridge.getVisibility() === true;
      } catch {
        // A native visibility read that fails cannot prove that the popup is
        // visible, so keep the transient surface closed until the host says so.
        return false;
      }
    }
    return documentRef.visibilityState !== "hidden";
  };
  const render = () => {
    const projection = createTrayPopupProjection(data ?? {}, {
      range,
      timeZone: USER_TIME_ZONE,
    });
    renderTrayPopup(documentRef, projection, {
      t: localization.t,
      bridge,
      mainModel,
      requiresMainModel,
      formattingLocale: localization.locale(),
    });
  };
  const loadData = async () => {
    const sequence = ++loadSequence;
    try {
      const next = await client.load();
      if (sequence === loadSequence) data = next;
    } catch {
      // A previously rendered snapshot remains the last-known result. On the
      // first load the null snapshot keeps every numeric field unavailable.
    }
    if (sequence !== loadSequence) return;
    render();
    // Main-process smoke and UI checks wait for the first bounded companion
    // read rather than mistaking the loading shell for a populated surface.
    documentRef.documentElement?.setAttribute("data-tray-popup-ready", "true");
  };
  const requestLoad = () => {
    if (!isVisible()) {
      loadPending = true;
      return Promise.resolve(null);
    }
    if (loadInFlight !== null) {
      loadPending = true;
      return loadInFlight;
    }
    loadPending = false;
    const promise = loadData();
    loadInFlight = promise;
    void promise.finally(() => {
      if (loadInFlight !== promise) return;
      loadInFlight = null;
      if (loadPending && isVisible()) {
        loadPending = false;
        void requestLoad();
      }
    }).catch(() => {});
    return promise;
  };
  render();
  const stopContentHeightObserver = observeTrayPopupContentHeight({
    windowRef,
    documentRef,
  });
  windowRef.addEventListener?.("pagehide", stopContentHeightObserver, { once: true });
  for (const button of documentRef.querySelectorAll?.("[data-history-range]") ?? []) {
    button.addEventListener("click", () => {
      if (Object.hasOwn(TRAY_POPUP_HISTORY_RANGES, button.dataset.historyRange)) {
        range = button.dataset.historyRange;
        render();
      }
    });
  }
  for (const button of documentRef.querySelectorAll?.("[data-action]") ?? []) {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const action = button.dataset.action;
      if (requestTrayPopupAction(bridge, action)) return;
      if (action !== "refresh") return;
      try {
        await client.refresh();
        await requestLoad();
      } catch {
        // The fallback refresh path keeps the existing snapshot visible.
      }
    });
  }
  if (requiresMainModel) {
    bridge.onModel((nextModel) => {
      // This repaint is synchronous and presentation-only: lifecycle state
      // must disable Refresh before any companion read completes or begins.
      mainModel = mainTrayPresentation(nextModel);
      render();
      // The model is a lifecycle signal only. A hidden popup does not issue
      // requests; visibility/opening below coalesces one refresh instead.
      loadPending = true;
      if (isVisible()) void requestLoad();
    });
  }
  const onVisibilityChange = () => {
    if (isVisible()) {
      // A visible transition represents a fresh popup presentation, even if
      // no companion model event arrived while the window was hidden.
      loadPending = true;
      void requestLoad();
    } else {
      loadPending = true;
    }
  };
  documentRef.addEventListener?.("visibilitychange", onVisibilityChange);
  if (typeof bridge?.onVisibility === "function") {
    bridge.onVisibility(() => onVisibilityChange());
  }
  windowRef.addEventListener?.("tibotattle:locale-change", () => {
    setMessageLocale(localization.locale());
    setFormattingLocale(localization.formatLocale());
    render();
  });
  await requestLoad();
  return data;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  void bootstrapTrayPopup();
}
