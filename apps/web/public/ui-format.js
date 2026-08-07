// Formatting and DOM helpers shared by the local dashboard and the public
// community surface. Translation language and regional formatting remain
// separate: choosing Spanish or Simplified Chinese never changes an instant,
// accounting value, or the browser/Mac regional number convention.
import { DEFAULT_LOCALE, canonicalLocale, translate } from "./localization.js";

function browserLocale() {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const requested = navigator.languages?.find((value) =>
    typeof value === "string" && value.trim() !== "",
  ) ?? navigator.language;
  return canonicalLocale(requested) ?? DEFAULT_LOCALE;
}

function systemTimeZone() {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof value === "string" && value.length > 0 ? value : "UTC";
  } catch {
    return "UTC";
  }
}

export const USER_TIME_ZONE = systemTimeZone();
// Compatibility exports for existing browser modules. The values retain the
// old reporting-time semantics while their formatting follows the live locale.
export const REPORTING_TIME_ZONE = USER_TIME_ZONE;
export let USER_LOCALE = browserLocale();

let formattingLocale = USER_LOCALE;
let messageLocale = DEFAULT_LOCALE;

export function setFormattingLocale(value) {
  formattingLocale = canonicalLocale(value) ?? browserLocale();
  USER_LOCALE = formattingLocale;
  return formattingLocale;
}

export function getFormattingLocale() {
  return formattingLocale;
}

export function setMessageLocale(value) {
  messageLocale = canonicalLocale(value) ?? DEFAULT_LOCALE;
  return messageLocale;
}

export function getMessageLocale() {
  return messageLocale;
}

const USER_TIME_ZONE_OPTION = Object.freeze({ timeZone: USER_TIME_ZONE });

/**
 * One `Intl` formatter per (kind, locale, options) triple, for the whole
 * session.
 *
 * Constructing an `Intl.DateTimeFormat` or `Intl.NumberFormat` is one to two
 * orders of magnitude more expensive than calling `.format` on an existing one,
 * and the chart draw loop asks for the same handful of formatters once per
 * plotted point. A single wheel notch over a month of calibration evidence was
 * measured constructing 1,187 `Intl.DateTimeFormat` and 608 `Intl.NumberFormat`
 * instances — the pan/zoom lag the dashboard was reported for. Nothing about a
 * formatter depends on the value being formatted, so each one is built once.
 *
 * The cache key includes the formatting locale, so `setFormattingLocale` needs
 * no invalidation step: a new locale simply produces new keys, and the old
 * formatters stay valid for anything still rendering in the old locale.
 *
 * Option objects are serialized to build the key. Callers that format inside a
 * loop should pass a hoisted frozen constant (as every helper below does); the
 * serialization for those is then computed once and remembered, so the hot path
 * costs one `Map` lookup.
 */
const intlFormatters = new Map();
const intlOptionKeys = new WeakMap();

function intlOptionKey(options) {
  if (options === null || options === undefined) return "";
  const remembered = intlOptionKeys.get(options);
  if (remembered !== undefined) return remembered;
  const key = JSON.stringify(options);
  intlOptionKeys.set(options, key);
  return key;
}

function intlFormatter(Factory, kind, locale, options) {
  const key = `${kind}·${locale}·${intlOptionKey(options)}`;
  const cached = intlFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Factory(locale, options);
  intlFormatters.set(key, formatter);
  return formatter;
}

export function dateTimeFormatter(options = undefined, locale = formattingLocale) {
  return intlFormatter(Intl.DateTimeFormat, "date", locale, options);
}

export function numberFormatter(options = undefined, locale = formattingLocale) {
  return intlFormatter(Intl.NumberFormat, "number", locale, options);
}

function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export function formatNumber(value, options = undefined) {
  return numberFormatter(options).format(value);
}

export function formatDate(value, options = undefined) {
  const date = instant(value);
  if (date === null) throw new RangeError("A valid date is required");
  return dateTimeFormatter(options).format(date);
}

export function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function compact(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : formatNumber(number, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
}

const LOCAL_DATE_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  month: "short",
  day: "numeric",
  year: "numeric",
});

const LOCAL_DATE_TIME_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatLocal(value, { dateOnly = false } = {}) {
  const date = instant(value);
  if (date === null) return translate("format.unknown", {}, messageLocale);
  return dateTimeFormatter(dateOnly ? LOCAL_DATE_OPTIONS : LOCAL_DATE_TIME_OPTIONS)
    .format(date);
}

// Existing browser imports use this name. Keep it as an alias so all
// timestamp surfaces inherit the selected regional formatter.
export function formatReportingTime(value, options = {}) {
  return formatLocal(value, options);
}

/**
 * The timestamp shape used by every chart surface: axis ticks, SVG <title>
 * tooltips, and the tables printed directly beneath a chart.
 *
 * It is built from two independent formatters and one separator we choose,
 * never from a single date+time formatter. A combined formatter delegates the
 * join to ICU, and WebKit's ICU glues the two halves with a localized
 * connective — "Jan 5 at 3:04 PM" — that Node's ICU does not produce, so no
 * Node test can observe it. Composing the halves ourselves removes the glue by
 * construction rather than by pattern-matching a rendered string.
 *
 * It also carries no time-zone name. A chart states its zone once, in its
 * caption, through `formatTimeZoneLabel` (a "long generic" name such as
 * "Eastern Time"). Repeating a "short" name such as "EDT" on every point was
 * both noise and a direct contradiction of that caption.
 */
export const CHART_DAY_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  month: "short",
  day: "numeric",
});

export const CHART_CLOCK_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  hour: "numeric",
  minute: "2-digit",
});

export const CHART_MONTH_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  month: "short",
  year: "numeric",
});

export function formatChartTimestamp(value, { dateOnly = false } = {}) {
  const date = instant(value);
  if (date === null) return translate("format.unknown", {}, messageLocale);
  const day = dateTimeFormatter(CHART_DAY_OPTIONS).format(date);
  if (dateOnly) return day;
  const time = dateTimeFormatter(CHART_CLOCK_OPTIONS).format(date);
  return `${day} · ${time}`;
}

export function formatTimeZoneLabel({
  locale = formattingLocale,
  timeZone = USER_TIME_ZONE,
  value = new Date(),
} = {}) {
  try {
    const date = instant(value) ?? new Date();
    const selectedLocale = canonicalLocale(locale) ?? formattingLocale;
    const parts = new Intl.DateTimeFormat(selectedLocale, {
      timeZone,
      timeZoneName: "longGeneric",
    }).formatToParts(date);
    const label = parts.find((part) => part.type === "timeZoneName")?.value;
    return typeof label === "string" && label.trim() !== ""
      ? label
      : translate("format.localTime", {}, messageLocale);
  } catch {
    return translate("format.localTime", {}, messageLocale);
  }
}

/**
 * Choose a readable number of horizontal date ticks for the space the chart
 * actually occupies. The SVG viewBox is intentionally stable, so this helper
 * takes the rendered CSS width instead of the internal drawing width.
 */
export function adaptiveChartTickCount(
  renderedWidth,
  {
    left = 58,
    right = 22,
    minimumTickWidth = 132,
    minimum = 2,
    maximum = 7,
  } = {},
) {
  const width = finite(renderedWidth);
  const safeMinimum = Math.max(1, Math.floor(minimum));
  const safeMaximum = Math.max(safeMinimum, Math.floor(maximum));
  if (width === null || width <= 0) {
    return Math.min(safeMaximum, Math.max(safeMinimum, 4));
  }
  const plotWidth = Math.max(1, width - Math.max(0, left) - Math.max(0, right));
  const tickWidth = Math.max(1, minimumTickWidth);
  return Math.max(
    safeMinimum,
    Math.min(safeMaximum, Math.floor(plotWidth / tickWidth) + 1),
  );
}

/**
 * Keep timeline evidence states distinct before a residual is drawn. In
 * particular, a quiet matched window is not missing evidence, and a measured
 * residual is not silently promoted to an evidence gap.
 */
export function classifyTimelineEvidence({
  bracketed = false,
  sameReset = false,
  observed = null,
  expected = null,
  usageEvents = 0,
  apiCostUsd = 0,
} = {}) {
  const observedValue = finite(observed);
  const expectedValue = finite(expected);
  const events = Math.max(0, finite(usageEvents, 0));
  const cost = Math.max(0, finite(apiCostUsd, 0));
  const residual = observedValue === null || expectedValue === null
    ? null
    : observedValue - expectedValue;
  const status = !bracketed ? "missing_quota_bracket"
    : !sameReset ? "reset_or_track_change"
      : observedValue === null ? "backward_or_ambiguous"
        : observedValue === 0 && events === 0 && cost === 0 ? "inactive"
          : observedValue > 0 && events === 0
            ? "unexplained_without_local_activity"
            : events > 0 && cost === 0
              ? "unpriced_local_activity"
              : "matched";
  return Object.freeze({ status, residual });
}

/**
 * Resolve a requested accounting period without treating a missing period as
 * the all-data cache. The caller can use the returned id to disable or hide a
 * control whose evidence is not present in this payload.
 */
export function selectAvailableAccountingPeriod(periods, requested = "7d") {
  const available = new Set(
    (Array.isArray(periods) ? periods : [])
      .map((period) => period?.periodId)
      .filter((periodId) => typeof periodId === "string" && periodId !== ""),
  );
  if (available.has(requested)) return requested;
  // `all` is an explicit bounded-cache view, never an implicit fallback for
  // an unavailable indexed-history request.
  return ["7d", "30d", "24h", "history"]
    .find((periodId) => available.has(periodId)) ?? null;
}

export function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) {
    return translate("format.unknownAge", {}, messageLocale);
  }
  const formatter = new Intl.RelativeTimeFormat(messageLocale, {
    numeric: "always",
    style: "long",
  });
  if (seconds < 90) return formatter.format(-1, "minute");
  if (seconds < 7200) return formatter.format(-Math.round(seconds / 60), "minute");
  if (seconds < 172800) return formatter.format(-Number((seconds / 3600).toFixed(1)), "hour");
  return formatter.format(-Number((seconds / 86400).toFixed(1)), "day");
}

/**
 * Display casing for the identifier fragments this build has actually
 * reviewed. A fragment that is not listed here is one nobody has decided how
 * to present, and guessing is how a model ends up displayed under a name its
 * vendor does not use.
 */
const MODEL_NAME_FRAGMENTS = Object.freeze({
  auto: "Auto",
  claude: "Claude",
  codex: "Codex",
  gpt: "GPT",
  haiku: "Haiku",
  luna: "Luna",
  mini: "Mini",
  nano: "Nano",
  opus: "Opus",
  preview: "Preview",
  review: "Review",
  sol: "Sol",
  sonnet: "Sonnet",
  spark: "Spark",
  terra: "Terra",
  // Work Mode routing alias. The picker writes it as two capitals.
  wm: "WM",
});
const MODEL_VERSION_FRAGMENT = /^\d+(?:\.\d+)*$/;

/**
 * `gpt-5.6-sol` is a wire identifier, not a name a person reads. This turns it
 * into "GPT-5.6 Sol" without ever inventing one: every fragment must be a
 * reviewed word or a version number, and a single unreviewed fragment returns
 * the raw identifier untouched rather than a half-guessed name. Callers keep
 * the exact identifier available on hover, so nothing is lost either way.
 */
export function formatModelName(value) {
  if (typeof value !== "string") return "";
  const identifier = value.trim();
  if (identifier === "") return "";
  const fragments = identifier.toLowerCase().split("-");
  const parts = [];
  for (const [index, fragment] of fragments.entries()) {
    if (MODEL_VERSION_FRAGMENT.test(fragment)) {
      // A version binds to the family it qualifies - "GPT-5.6", not "GPT 5.6"
      // - but only in first position. Later numbers are their own word, which
      // is what keeps "Claude Sonnet 5" from becoming "Claude-Sonnet 5".
      if (index === 1 && parts.length === 1) parts[0] += `-${fragment}`;
      else parts.push(fragment);
      continue;
    }
    const word = MODEL_NAME_FRAGMENTS[fragment];
    if (word === undefined) return identifier;
    parts.push(word);
  }
  return parts.join(" ");
}

const CALENDAR_PART_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function localCalendarParts() {
  return dateTimeFormatter(CALENDAR_PART_OPTIONS);
}

export function reportingCalendarParts() {
  return localCalendarParts();
}

/**
 * Element helpers bound to one document. Passing the document in keeps these
 * usable from a unit test with a minimal document stand-in, and keeps a single
 * definition of "make an element" for both entry points.
 */
export function createDomHelpers(documentRef) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("A document with createElement is required.");
  }
  return {
    clear(element) {
      element.replaceChildren();
    },
    node(tag, className, text) {
      const element = documentRef.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = String(text);
      return element;
    },
  };
}
