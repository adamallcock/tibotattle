// Formatting and DOM helpers shared by the local dashboard and the public
// community surface. Translation language and regional formatting remain
// separate: choosing Spanish or Simplified Chinese never changes an instant,
// accounting value, or the browser/Mac regional number convention.
import {
  DEFAULT_LOCALE,
  canonicalLocale,
  translate,
  translatePlural,
} from "./localization.js";

// All display helpers use the same marker for an unavailable or unreported
// value. A numeric zero remains a real reading and is formatted as `0`.
export const UNKNOWN_DISPLAY_VALUE = "—";

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
  if (typeof options !== "object") return String(options);
  const remembered = intlOptionKeys.get(options);
  if (remembered !== undefined) return remembered;
  const key = JSON.stringify(options);
  intlOptionKeys.set(options, key);
  return key;
}

function intlFormatter(Factory, kind, locale, options) {
  const selectedLocale = canonicalLocale(locale) ?? DEFAULT_LOCALE;
  const key = `${kind}·${selectedLocale}·${intlOptionKey(options)}`;
  const cached = intlFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Factory(selectedLocale, options);
  intlFormatters.set(key, formatter);
  return formatter;
}

export function dateTimeFormatter(options = undefined, locale = formattingLocale) {
  return intlFormatter(Intl.DateTimeFormat, "date", locale, options);
}

export function numberFormatter(options = undefined, locale = formattingLocale) {
  return intlFormatter(Intl.NumberFormat, "number", locale, options);
}

export function relativeTimeFormatter(
  options = undefined,
  locale = messageLocale,
) {
  return intlFormatter(Intl.RelativeTimeFormat, "relative", locale, options);
}

function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

const DECIMAL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

/**
 * Accept finite numbers and decimal strings emitted by accounting APIs. The
 * string branch is deliberately narrower than `Number(value)`: values such as
 * `"0x10"` or an empty string are not displayable measurements.
 */
function numericValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (candidate === "" || !DECIMAL_NUMBER_PATTERN.test(candidate)) return null;
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

export function formatNumber(value, options = undefined) {
  const number = numericValue(value);
  return number === null
    ? UNKNOWN_DISPLAY_VALUE
    // Intl preserves decimal strings beyond JavaScript's safe-integer range;
    // keep the validated source string for accounting values instead of
    // needlessly rounding it through Number first.
    : numberFormatter(options).format(
      typeof value === "string" ? value.trim() : number,
    );
}

export function formatDate(value, options = undefined) {
  const date = instant(value);
  if (date === null) throw new RangeError("A valid date is required");
  return dateTimeFormatter(options).format(date);
}

export function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function decimalPlaces(value) {
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new RangeError("Fraction digits must be an integer from 0 to 20");
  }
  return value;
}

/**
 * Format a count with grouping and no fractional part. Counts are exact
 * display facts: an absent count stays unavailable, while zero remains zero.
 * `missing` may be set to `null` when a caller needs to withhold the cell.
 */
export function formatCount(value, { missing = UNKNOWN_DISPLAY_VALUE } = {}) {
  const number = numericValue(value);
  if (number === null || number < 0) return missing;
  return formatNumber(Math.trunc(number), { maximumFractionDigits: 0 });
}

/** Format a finite decimal with fixed locale-aware precision. */
export function formatDecimal(value, digits = 0) {
  const number = numericValue(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  const places = decimalPlaces(digits);
  return formatNumber(value, {
    maximumFractionDigits: places,
    minimumFractionDigits: places,
  });
}

/**
 * Format a USD amount using the requested fixed precision. API-equivalent
 * amounts have their own `formatApiMoney` helper below because it preserves a
 * visible under-one-cent bound at its fixed two-decimal precision.
 */
export function formatMoney(value, digits = 0) {
  const number = numericValue(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  const places = decimalPlaces(digits);
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/**
 * Format a percentage expressed in percentage points (0–100), never as a
 * fractional input. Rounded interior values that would look like an endpoint
 * retain a bound so a sliver is not presented as exact zero or full coverage.
 */
export function formatPercent(value, digits = 0) {
  const number = numericValue(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  const requestedPlaces = decimalPlaces(digits);
  // Whole values are easier to scan as whole percentages, matching the
  // established dashboard copy. Fractional values retain the requested detail.
  const places = Number.isInteger(number) ? 0 : requestedPlaces;
  const percentFormatter = numberFormatter({
    maximumFractionDigits: places,
    minimumFractionDigits: 0,
    style: "percent",
  });
  const format = (amount) => percentFormatter.format(amount / 100);
  const step = 10 ** -places;
  const rendered = format(number);
  if (number > 0 && rendered === format(0)) return `<${format(step)}`;
  if (number < 100 && rendered === format(100)) return `>${format(100 - step)}`;
  return rendered;
}

/** Format a percentage-point diagnostic with its unit. */
export function formatPp(value, digits = 1) {
  const number = numericValue(value);
  return number === null
    ? UNKNOWN_DISPLAY_VALUE
    : `${formatDecimal(number, digits)} pp`;
}

/** Keep the sign visible because it identifies the side of the baseline. */
export function formatSignedPp(value, digits = 1) {
  const number = numericValue(value);
  return number === null
    ? UNKNOWN_DISPLAY_VALUE
    : `${number < 0 ? "" : "+"}${formatPp(number, digits)}`;
}

/** Format a signed percentage-point-hour diagnostic through localized copy. */
export function formatSignedPpHours(value, digits = 1) {
  const number = numericValue(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  return translate("format.ppHours", {
    value: `${number < 0 ? "" : "+"}${formatDecimal(number, digits)}`,
  }, messageLocale);
}

/**
 * Format a duration in milliseconds with localized plural units. A missing or
 * negative duration is unavailable; one or more milliseconds always reports at
 * least one minute, matching the dashboard's established span convention.
 */
export function formatSpanLength(spanMs) {
  const milliseconds = numericValue(spanMs);
  if (milliseconds === null || milliseconds < 0) return UNKNOWN_DISPLAY_VALUE;
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 90) {
    return translatePlural("format.durationMinute", minutes, {
      count: formatCount(minutes),
    }, messageLocale);
  }
  const hours = minutes / 60;
  if (hours < 48) {
    const value = Number(hours.toFixed(hours < 10 ? 1 : 0));
    return translatePlural("format.durationHour", value, {
      count: formatDecimal(value, hours < 10 ? 1 : 0),
    }, messageLocale);
  }
  const value = Number((hours / 24).toFixed(1));
  return translatePlural("format.durationDay", value, {
    count: formatDecimal(value, 1),
  }, messageLocale);
}

/**
 * Format the time until an ISO timestamp (or Date/epoch value). `now` is
 * injectable for deterministic callers and tests; the timestamp's own instant
 * remains untouched by locale or time-zone presentation.
 */
export function formatTimeRemaining(value, { now = Date.now() } = {}) {
  const timestamp = instant(value)?.valueOf();
  const current = now instanceof Date
    ? now.valueOf()
    : typeof now === "string"
      ? instant(now)?.valueOf()
      : numericValue(now);
  if (timestamp === undefined || current === null) {
    return translate("format.timeUnavailable", {}, messageLocale);
  }
  if (!Number.isFinite(current)) {
    return translate("format.timeUnavailable", {}, messageLocale);
  }
  const remainingMs = timestamp - current;
  if (remainingMs <= 0) return translate("format.resetDue", {}, messageLocale);
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return translate("format.remainingDays", {
      days: formatCount(days),
      hours: formatCount(hours),
    }, messageLocale);
  }
  if (hours > 0) {
    return translate("format.remainingHours", {
      hours: formatCount(hours),
      minutes: formatCount(minutes),
    }, messageLocale);
  }
  return translate("format.remainingMinutes", {
    minutes: formatCount(minutes),
  }, messageLocale);
}

export function compact(value) {
  const number = numericValue(value);
  return number === null
    ? UNKNOWN_DISPLAY_VALUE
    : formatNumber(number, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
}

/** `compact`, but never rounded down to a single significant figure.
 *
 * The headline stat cards were reporting a million-odd turns as "1M", which
 * reads as a placeholder rather than a measurement and hides a range of nearly
 * two to one. Two significant figures is the least that carries information;
 * three is allowed so a value already at that precision is not coarsened. */
export function compactPrecise(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : formatNumber(number, {
      notation: "compact",
      minimumSignificantDigits: 2,
      maximumSignificantDigits: 3,
    });
}

const LOCAL_DATE_OPTIONS = Object.freeze({
  ...USER_TIME_ZONE_OPTION,
  month: "short",
  day: "numeric",
  year: "numeric",
});

const UTC_CALENDAR_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const UTC_CALENDAR_DAY_OPTIONS = Object.freeze({
  timeZone: "UTC",
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

/**
 * Format an API day partition without turning it into a local instant.
 *
 * Community `day` values are UTC calendar-day identifiers, not timestamps.
 * JavaScript parses `2026-08-14` as midnight UTC, which becomes Aug 13 in a
 * time zone west of Greenwich when passed through `formatLocal`.
 */
export function formatUtcCalendarDay(value) {
  if (typeof value !== "string" || !UTC_CALENDAR_DAY_PATTERN.test(value)) {
    return translate("format.unknown", {}, messageLocale);
  }
  const date = instant(`${value}T00:00:00.000Z`);
  if (date === null || date.toISOString().slice(0, 10) !== value) {
    return translate("format.unknown", {}, messageLocale);
  }
  return dateTimeFormatter(UTC_CALENDAR_DAY_OPTIONS).format(date);
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

export const CHART_TICK_TIME_ONLY_SPAN_MS = 36 * 60 * 60 * 1_000;
export const CHART_TICK_MONTH_ONLY_SPAN_MS = 365 * 24 * 60 * 60 * 1_000;

export function formatChartTimestamp(value, { dateOnly = false } = {}) {
  const date = instant(value);
  if (date === null) return translate("format.unknown", {}, messageLocale);
  const day = dateTimeFormatter(CHART_DAY_OPTIONS).format(date);
  if (dateOnly) return day;
  const time = dateTimeFormatter(CHART_CLOCK_OPTIONS).format(date);
  return `${day} · ${time}`;
}

/**
 * Choose a stable axis-tick shape from the displayed domain. Short spans use
 * clock time, ordinary spans use a day, and long spans use month plus year.
 * Date-only callers always use the local calendar day. All shapes retain the
 * reader's detected time zone and selected number/date locale.
 */
export function formatChartTimeLabel(
  value,
  { dateOnly = false, spanMs = null } = {},
) {
  const date = instant(value);
  if (date === null) return translate("format.unknown", {}, messageLocale);
  const span = numericValue(spanMs);
  const resolution = dateOnly ? "date"
    : span === null ? "dateAndTime"
      : span <= CHART_TICK_TIME_ONLY_SPAN_MS ? "time"
        : span <= CHART_TICK_MONTH_ONLY_SPAN_MS ? "date"
          : "month";
  if (resolution === "time") {
    return dateTimeFormatter(CHART_CLOCK_OPTIONS).format(date);
  }
  if (resolution === "month") {
    return dateTimeFormatter(CHART_MONTH_OPTIONS).format(date);
  }
  const day = dateTimeFormatter(CHART_DAY_OPTIONS).format(date);
  if (resolution === "date") return day;
  return `${day} · ${dateTimeFormatter(CHART_CLOCK_OPTIONS).format(date)}`;
}

export function formatTimeZoneLabel({
  locale = formattingLocale,
  timeZone = USER_TIME_ZONE,
  value = new Date(),
} = {}) {
  try {
    const date = instant(value) ?? new Date();
    const selectedLocale = canonicalLocale(locale) ?? formattingLocale;
    const parts = dateTimeFormatter({
      timeZone,
      timeZoneName: "longGeneric",
    }, selectedLocale).formatToParts(date);
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
  poolSaturated = false,
} = {}) {
  const observedValue = finite(observed);
  const expectedValue = finite(expected);
  const events = Math.max(0, finite(usageEvents, 0));
  const cost = Math.max(0, finite(apiCostUsd, 0));
  const residual = observedValue === null || expectedValue === null
    ? null
    : observedValue - expectedValue;
  // A pegged pool is its own evidence state, not an ambiguity: the window is
  // bracketed, but a display at its ceiling cannot move, so no residual is
  // measurable there ("allowance exhausted").
  //
  // Saturation is tested BEFORE the reset check, and that order is the whole
  // reason the state is reachable. Exhausting a pool spawns a fresh one with a
  // new `resets_at`, so the boundary changes at the very instant the ceiling is
  // hit: behind `!sameReset` the saturated branch was shadowed by its own
  // precondition and had never once classified a window. The peg is also the
  // more specific fact — it names WHY the window is unmeasurable, where
  // "boundary changed" only names when. `bracketed` still comes first, because
  // without a reading on the start edge there is no ceiling to observe.
  const status = !bracketed ? "missing_quota_bracket"
    : poolSaturated === true ? "pool_saturated"
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
  const seconds = numericValue(value);
  if (seconds === null) {
    return translate("format.unknownAge", {}, messageLocale);
  }
  const formatter = relativeTimeFormatter({
    numeric: "always",
    style: "long",
  }, messageLocale);
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
  astra: "Astra",
  auto: "Auto",
  claude: "Claude",
  codex: "Codex",
  fable: "Fable",
  gpt: "GPT",
  haiku: "Haiku",
  luna: "Luna",
  mini: "Mini",
  mythos: "Mythos",
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
const REVIEWED_MODEL_DISPLAY_NAMES = Object.freeze({
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-mythos-5-1": "Claude Mythos 5.1",
  "claude-opus-5-5": "Claude Opus 5.5",
  "gpt-6.1-astra": "GPT-6.1 Astra (forecast)",
});

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
  const reviewedLabel = REVIEWED_MODEL_DISPLAY_NAMES[identifier.toLowerCase()];
  if (reviewedLabel) return reviewedLabel;
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

// Shared accounting-table formats: fixed precision and honest endpoint bounds.
export function formatApiMoney(value) {
  // Decimal accounting strings stay exact through Intl display rounding.
  const number = numericValue(value);
  if (number === null) return UNKNOWN_DISPLAY_VALUE;
  if (number > 0 && number < .01) {
    return `<${formatMoney(.01, 2)}`;
  }
  return formatMoney(value, 2);
}

/**
 * A share for a table column, always at one decimal place.
 *
 * `formatPercent` drops to whole numbers whenever the value happens to be an
 * integer, which is right for a sentence and wrong for a column: it renders
 * "20%" directly above "20.9%", so the decimal point moves down the page and
 * two figures that exist to be compared have to be read digit by digit. Here
 * the precision is fixed, and the same bounded "<" idiom keeps a sliver from
 * rendering as an exact zero it is not.
 *
 * Returns `null` when the denominator cannot carry a share at all, so callers
 * withhold the cell rather than printing a share of nothing.
 */
export function formatSharePercent(part, whole) {
  const numerator = numericValue(part);
  const denominator = numericValue(whole);
  if (numerator === null || denominator === null || denominator <= 0) return null;
  if (numerator < 0) return null;
  const percentFormatter = numberFormatter({
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    style: "percent",
  });
  const format = (amount) => percentFormatter.format(amount / 100);
  const value = numerator / denominator * 100;
  const rendered = format(value);
  if (value > 0 && rendered === format(0)) return `<${format(.1)}`;
  if (value < 100 && rendered === format(100)) return `>${format(99.9)}`;
  return rendered;
}

// Shared local thread labels; explicit collaboration parents stay separate links.
function cacheDropThreadId(value) {
  return typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function cacheDropThreadName(thread, t) {
  return typeof thread?.name === "string" && thread.name.trim()
    ? thread.name.trim()
    : t("accounting.cacheDropThread.fallback", {
      id: cacheDropThreadId(thread?.id)?.slice(0, 8) ?? "",
    });
}

export function formatCodexThreadParts(thread, t) {
  const id = cacheDropThreadId(thread?.id);
  if (id === null) return [];
  const parentId = cacheDropThreadId(thread.parent?.id);
  const parent = parentId !== null && parentId !== id ? thread.parent : null;
  if (thread?.origin === "auto_review") {
    // Internal reviews open only an explicitly resolved, accessible parent.
    // Never fall back to the internal review session's UUID.
    return parent === null ? [{
      name: "Auto review",
      href: null,
      autoReview: true,
    }] : [{
      name: cacheDropThreadName(parent, t),
      href: `codex://threads/${parentId}`,
      worker: false,
      autoReview: true,
    }];
  }
  const nickname = typeof thread.nickname === "string"
    ? thread.nickname.trim()
    : "";
  const worker = parent !== null || nickname !== "";
  const parts = parent === null ? [] : [{
    name: cacheDropThreadName(parent, t),
    href: `codex://threads/${parentId}`,
    worker: false,
  }];
  parts.push({
    name: worker
      ? t("accounting.cacheDropThread.subworker", {
        name: nickname || cacheDropThreadName(thread, t),
      })
      : cacheDropThreadName(thread, t),
    href: `codex://threads/${id}`,
    worker,
  });
  return parts;
}
